import {gql} from '@apollo/client';
export const GET_FACULTY_REVISION_PLANS=gql`query FacultyRevisionPlans($courseId:Int!){facultyRevisionPlans(courseId:$courseId){outcomeId code lectureId lectureTitle guidance status approvedAt}}`;
export const GET_MY_REVISION_RECOMMENDATIONS=gql`query MyRevisionRecommendations($courseId:Int!){myRevisionRecommendations(courseId:$courseId){outcomeId code description lectureId lectureTitle guidance attempted correct}}`;
export const SAVE_REVISION_PLAN=gql`mutation SaveRevisionPlan($courseId:Int!,$outcomeId:Int!,$lectureId:Int!,$guidance:String!,$approve:Boolean!){saveRevisionPlan(courseId:$courseId,outcomeId:$outcomeId,lectureId:$lectureId,guidance:$guidance,approve:$approve){outcomeId code lectureId guidance status approvedAt}}`;
export const WITHDRAW_REVISION_PLAN=gql`mutation WithdrawRevisionPlan($courseId:Int!,$outcomeId:Int!){withdrawRevisionPlan(courseId:$courseId,outcomeId:$outcomeId){outcomeId code lectureId guidance status approvedAt}}`;
